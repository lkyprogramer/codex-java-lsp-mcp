package demojpa;

import jakarta.persistence.Entity;
import jakarta.persistence.ManyToOne;

@Entity
public class OrderEntity {
  private Long id;

  @ManyToOne
  private CustomerEntity customer;

  public Long getId() {
    return id;
  }

  public CustomerEntity getCustomer() {
    return customer;
  }
}
